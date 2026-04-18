import { Body, Controller, DefaultValuePipe, Get, Param, ParseBoolPipe, ParseIntPipe, Patch, Post, Query, ValidationPipe } from '@nestjs/common';
import { UsersService } from './user.service';
import { CreateUserDTO } from './dto/create-user.dto';
import { GetUserParamDto } from './dto/get-user-param-dto';
import { UpdateUserDTO } from './dto/update-user.dto';

@Controller('users')
export class UsersController {
    constructor(private usersService:UsersService){
    }
    @Get()
    getUsers() {
       
    
        return this.usersService.getAllUsers();
    }
    @Post()
    createUser(@Body() user:CreateUserDTO){
     return this.usersService.createUser(user);
     
         
    }
 
    
  
}
